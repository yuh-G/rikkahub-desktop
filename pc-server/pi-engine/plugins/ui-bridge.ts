// pi-engine/plugins/ui-bridge.ts — 插件的界面上下文(ctx.ui)→ 契约 host.interaction(方案 §5.5 处置表、§5.11,P5.5)
//
// 绑进会话后 ctx.hasUI 为真、ctx.mode 为 "rpc"(权限插件据此走「询问用户」而不是全部拒绝)。
// - select / confirm / input:经 host.interaction.dialog 请求-应答;插件给的超时 / 取消信号在这里处理,
//   先到先答「取消」并经 dismiss 让应用收起。取消的回答与 pi 无界面时一致(confirm = false,其余 undefined)。
// - notify / setStatus / setWidget(字符串数组)/ setWorkingMessage:经 host.interaction.show 单向通知,纯文本。
// - 其余(editor、custom、组件工厂形态的 setWidget、页眉页脚、编辑器、主题切换…)落空。
// 方法一律是不依赖 this 的闭包:pi 的 setUIContext 会把对象展开成新对象再用。
// tool_call 处理期间的对话框由裁决层吞掉(guardPiPluginDialogs),绑定前必须先经过它。

import type {
  ExtensionUIContext,
  ExtensionUIDialogOptions,
} from "../../../pi/packages/coding-agent/src/core/extensions/types.ts";
import type { Theme } from "../../../pi/packages/coding-agent/src/modes/interactive/theme/theme.ts";
import type {
  EngineDialogAnswer,
  EngineDialogCall,
  EngineDialogRequest,
  EngineErrorReport,
  EngineUiNotice,
  EngineUiNoticeCall,
  TurnRef,
} from "../../engines/contract";
import { activePiPluginId } from "./arbiter";

/** 本轮的界面通道(驱动把 host.interaction 绑上 turnId 后交给这里)。 */
export interface PiPluginInteraction {
  dialog(call: Omit<EngineDialogCall, keyof TurnRef>): Promise<EngineDialogAnswer>;
  dismiss(requestId: string): void;
  show(call: Omit<EngineUiNoticeCall, keyof TurnRef>): void;
}

// pi 的全局主题只在它的命令行入口初始化,别处一读就抛错;插件拿主题给状态文本上色,我们只显示纯文本。
const plain = (text: string) => text;
const PLAIN_THEME = {
  name: "plain",
  style: plain,
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: plain,
  italic: plain,
  underline: plain,
  inverse: plain,
  strikethrough: plain,
  getFgAnsi: () => "",
  getBgAnsi: () => "",
  getColorMode: () => "truecolor",
  getThinkingBorderColor: () => plain,
  getBashModeBorderColor: () => plain,
  appearance: "dark",
  colors: {},
} as unknown as Theme;

// 插件也可能自己拼终端颜色码。
const ANSI_SGR = /\x1b\[[0-9;]*m/g;
const stripAnsi = (text: string) => text.replace(ANSI_SGR, "");

export function createPiPluginUi(
  port: PiPluginInteraction,
  options: { pluginIds: readonly string[]; report?: (report: EngineErrorReport) => void },
): ExtensionUIContext {
  // 署名:插件工具执行与 tool_call / 事件处理函数里由裁决层的作用域给出;只装了一个插件时认领不到也是它。
  const sourceOf = () => activePiPluginId() ?? (options.pluginIds.length === 1 ? options.pluginIds[0]! : "");
  const show = (notice: EngineUiNotice) => port.show({ source: sourceOf(), notice });

  function dialog<T>(
    request: EngineDialogRequest,
    opts: ExtensionUIDialogOptions | undefined,
    cancelled: T,
    read: (value: string | boolean) => T,
  ): Promise<T> {
    if (opts?.signal?.aborted) return Promise.resolve(cancelled);
    const requestId = crypto.randomUUID();
    return new Promise<T>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (value: T, dismiss: boolean) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        opts?.signal?.removeEventListener("abort", onAbort);
        if (dismiss) port.dismiss(requestId);
        resolve(value);
      };
      const onAbort = () => settle(cancelled, true);
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts?.timeout && opts.timeout > 0) timer = setTimeout(() => settle(cancelled, true), opts.timeout);
      port.dialog({ requestId, source: sourceOf(), request }).then(
        (answer) => settle(answer.cancelled ? cancelled : read(answer.value), false),
        (err: unknown) => {
          options.report?.({
            domain: "pi-engine",
            severity: "warn",
            message: `插件对话框未送达:${err instanceof Error ? err.message : String(err)}`,
            code: "pi_plugin_dialog_failed",
          });
          settle(cancelled, false);
        },
      );
    });
  }

  const noop = () => undefined;
  return {
    select: (title, items, opts) =>
      dialog({ kind: "select", title, options: [...items] }, opts, undefined, (value) => (typeof value === "string" ? value : undefined)),
    confirm: (title, message, opts) => dialog({ kind: "confirm", title, message }, opts, false, (value) => value === true),
    input: (title, placeholder, opts) =>
      dialog(
        { kind: "input", title, ...(placeholder ? { placeholder } : {}) },
        opts,
        undefined,
        (value) => (typeof value === "string" ? value : undefined),
      ),
    notify: (message, type) =>
      show({ kind: "notify", message: stripAnsi(String(message)), level: type === "warning" || type === "error" ? type : "info" }),
    setStatus: (key, text) => show({ kind: "status", key, text: typeof text === "string" ? stripAnsi(text) : null }),
    setWidget: (key: string, content: unknown) => {
      // 组件工厂形态要终端渲染,落空。
      if (typeof content === "function") return;
      show({ kind: "widget", key, lines: Array.isArray(content) ? content.map((line) => stripAnsi(String(line))) : null });
    },
    setWorkingMessage: (message) => show({ kind: "working", text: typeof message === "string" ? stripAnsi(message) : null }),
    editor: async () => undefined,
    custom: async () => undefined as never,
    onTerminalInput: () => noop,
    setWorkingVisible: noop,
    setWorkingIndicator: noop,
    setHiddenThinkingLabel: noop,
    setFooter: noop,
    setHeader: noop,
    setTitle: noop,
    pasteToEditor: noop,
    setEditorText: noop,
    getEditorText: () => "",
    addAutocompleteProvider: noop,
    setEditorComponent: noop,
    getEditorComponent: () => undefined,
    theme: PLAIN_THEME,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Themes are not supported" }),
    getToolsExpanded: () => false,
    setToolsExpanded: noop,
  };
}
