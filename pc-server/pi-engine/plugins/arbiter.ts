// pi-engine/plugins/arbiter.ts — 插件裁决层(方案 §5.5「P5.0 定稿」;资源加载器的 extensionsOverride 接在这里)
//
// 裁决只针对插件经 pi 接口登记的东西,插件自身的代码不管(D6)。两种时机:
// - 加载期(arbitratePiExtensions):与本轮应用工具 / pi 内建工具同名、以 mcp__ 开头的工具,pi 内建指令名,
//   保留事件的处理函数,排队中的供应商 / 虚拟模型 / MCP 登记,都拿掉;终端界面类登记留着但记「不支持」;
//   tool_call 处理函数逐个包一层做行为裁决(D7)。
// - 运行期(guardPiPluginRuntime,会话建好后、session_start 之前):pi 的 bindCore 已把动作装进 runtime,
//   这里把保留域的运行期入口换成「不生效 + 记审计」;运行期 registerTool 经 refreshTools 走同一套工具规则;
//   session_start 里补登记的 tool_call 处理函数由 arbitrateLatePiRegistrations 补包。
// 每一次拿掉 / 作废 / 否决 / 停用都记一条审计,署插件 id(按扩展的加载路径认领)。
//
// tool_call 行为裁决(E17 实测的做法):处理函数拿到的 ctx.ui 是带标记的一份,另用异步上下文兜底(插件可能
// 缓存了会话级 ui,由 ui-context 认领);处理期间只要调用了对话框,对话框不显示、按取消回答,这次的返回值
// 连同对入参的改写一起作废。没弹窗的否决照常生效,理由前缀插件 id(模型与工具卡都看得到是谁拒绝的)。
// 已知缺口:session_start 之后才登记的 tool_call 处理函数不经裁决;包装后插件对 tool_call 的取消登记无效。
//
// 插件工具在 P5.4 审批接上之前一律不进会话(放行等于绕过审批直接执行),这一项不是裁决结论,不记审计。

import { AsyncLocalStorage } from "node:async_hooks";
import type {
  Extension,
  ExtensionContext,
  ExtensionRuntime,
  ExtensionUIContext,
  LoadExtensionsResult,
  ToolCallEvent,
  ToolCallEventResult,
} from "../../../pi/packages/coding-agent/src/core/extensions/types.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../../pi/packages/coding-agent/src/core/slash-commands.ts";
import { allToolNames } from "../../../pi/packages/coding-agent/src/core/tools/index.ts";
import type { EngineErrorReport } from "../../engines/contract";
import { pluginIdForExtensionPath, type PiPluginEntry } from "./entries";

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

export interface PiPluginAuditRecord {
  /** 空串 = 认领不到插件(pi 的 setModel / setThinkingLevel 不带调用方)。 */
  pluginId: string;
  /** removed = 保留域或重名,拿掉;unsupported = 登记留着但不会生效;disabled = 按手动开关停用;
   *  discarded = 处理期间弹了对话框,这次裁决作废;vetoed = 没弹窗的否决,已生效。 */
  action: "removed" | "unsupported" | "disabled" | "discarded" | "vetoed";
  /** removed / unsupported / disabled:tool:<名>、command:<名>、event:<名>、provider:<id>、model:<供应商>/<id>、
   *  mcp:<名>、set-model、set-thinking-level、shortcut / flag / *-renderer…;discarded / vetoed:工具名。 */
  subject: string;
  /** vetoed:插件给的理由。 */
  detail?: string;
}

export interface PiPluginPolicy {
  entries: readonly PiPluginEntry[];
  /** 本轮应用工具名:插件工具与之同名即拿掉。 */
  appToolNames: ReadonlySet<string>;
  /** 用户手动停用了工具调用钩子的插件 id(D7 的兜底开关)。 */
  toolCallHooksDisabled: ReadonlySet<string>;
  /** 运行期审计(否决、作废、运行期登记)的出口;加载期的审计随裁决结果返回。 */
  onAudit: (record: PiPluginAuditRecord) => void;
}

/** 拿掉处理函数的事件:项目信任 / 技能与模板资源 / 缓存策略 / 请求改写 / MCP(归应用)。 */
const RESERVED_EVENTS = [
  "project_trust",
  "resources_discover",
  "cache_warming_decision",
  "before_provider_request",
  "before_provider_headers",
  "mcp_servers_change",
];

const RESERVED_COMMANDS = new Set([...BUILTIN_SLASH_COMMANDS.map((command) => command.name), "mcp", "skill"]);

const isReservedCommand = (name: string) => RESERVED_COMMANDS.has(name) || name.startsWith("skill:");

function isReservedToolName(name: string, appToolNames: ReadonlySet<string>): boolean {
  return appToolNames.has(name) || (allToolNames as ReadonlySet<string>).has(name) || name.startsWith("mcp__");
}

function pluginIdOf(policy: PiPluginPolicy, extensionPath: string | undefined): string {
  if (!extensionPath) return "";
  return pluginIdForExtensionPath(policy.entries, extensionPath) ?? extensionPath;
}

// ---- tool_call 行为裁决 ----

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor", "custom"]);

/** 正在处理 tool_call 的那次调用:处理期间弹过对话框就记下。 */
interface DialogProbe {
  prompted: boolean;
}

const toolCallScope = new AsyncLocalStorage<DialogProbe>();

/** 被吞掉的对话框按「取消」回答(与 pi 无界面时各方法的返回值一致)。 */
const cancelledAnswer = (method: string) => Promise.resolve(method === "confirm" ? false : undefined);

function dialogGuard(ui: ExtensionUIContext, probeOf: () => DialogProbe | undefined): ExtensionUIContext {
  return new Proxy(ui, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || !DIALOG_METHODS.has(prop) || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const probe = probeOf();
        if (!probe) return value.apply(target, args);
        probe.prompted = true;
        return cancelledAnswer(prop);
      };
    },
  });
}

/** 会话级界面的兜底:插件在别处缓存了 ctx.ui、在 tool_call 处理期间调用对话框,同样吞掉并作废这次裁决。
 *  界面桥(P5.5)绑进会话前必须先经过它。 */
export function guardPiPluginDialogs(ui: ExtensionUIContext): ExtensionUIContext {
  return dialogGuard(ui, () => toolCallScope.getStore());
}

function replaceContents(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(target)) if (!(key in source)) delete target[key];
  Object.assign(target, source);
}

function arbitrateToolCallHook(pluginId: string, hook: HandlerFn, onAudit: PiPluginPolicy["onAudit"]): HandlerFn {
  return async (...args: unknown[]) => {
    const [event, ctx] = args as [ToolCallEvent, ExtensionContext];
    const probe: DialogProbe = { prompted: false };
    const tagged = new Proxy(ctx, {
      get: (target, prop) => (prop === "ui" ? dialogGuard(target.ui, () => probe) : Reflect.get(target, prop, target)),
    });
    // pi 约定插件改参数 = 就地改 event.input;交给它一份副本,裁决有效才写回。
    const draft = { ...event, input: structuredClone(event.input) } as ToolCallEvent;
    let verdict: unknown;
    try {
      verdict = await toolCallScope.run(probe, () => hook(draft, tagged));
    } catch (err) {
      // 弹过对话框的处理函数抛错同样作废(插件多半是拿到取消值后放弃);没弹窗的抛错照 pi 原语义阻止执行。
      if (!probe.prompted) throw err;
    }
    if (probe.prompted) {
      onAudit({ pluginId, action: "discarded", subject: event.toolName });
      return undefined;
    }
    replaceContents(event.input as Record<string, unknown>, draft.input as Record<string, unknown>);
    const result = verdict as ToolCallEventResult | undefined;
    if (!result?.block) return verdict;
    const reason = result.reason?.trim() || "Tool execution was blocked";
    onAudit({ pluginId, action: "vetoed", subject: event.toolName, detail: reason });
    return { ...result, reason: `Blocked by plugin "${pluginId}": ${reason}` };
  };
}

const ARBITRATED = Symbol("rikkahub.arbitrated");

function wrapToolCallHandlers(extension: Extension, pluginId: string, policy: PiPluginPolicy): void {
  const handlers = extension.handlers.get("tool_call");
  if (!handlers) return;
  extension.handlers.set(
    "tool_call",
    handlers.map((handler) => {
      if ((handler as { [ARBITRATED]?: true })[ARBITRATED]) return handler;
      const wrapped = arbitrateToolCallHook(pluginId, handler as HandlerFn, policy.onAudit);
      return Object.assign(wrapped, { [ARBITRATED]: true as const });
    }),
  );
}

// ---- 加载期 ----

/** 裁决加载结果(就地修改并返回同一个结果对象),返回加载期审计。 */
export function arbitratePiExtensions(
  result: LoadExtensionsResult,
  policy: PiPluginPolicy,
): { result: LoadExtensionsResult; audit: PiPluginAuditRecord[] } {
  const audit: PiPluginAuditRecord[] = [];
  for (const extension of result.extensions) {
    const pluginId = pluginIdOf(policy, extension.path);
    const record = (action: PiPluginAuditRecord["action"], subject: string) => audit.push({ pluginId, action, subject });

    for (const name of [...extension.tools.keys()]) {
      if (isReservedToolName(name, policy.appToolNames)) record("removed", `tool:${name}`);
      extension.tools.delete(name);
    }
    for (const name of [...extension.commands.keys()]) {
      if (!isReservedCommand(name)) continue;
      extension.commands.delete(name);
      record("removed", `command:${name}`);
    }
    for (const event of RESERVED_EVENTS) {
      if (!extension.handlers.delete(event)) continue;
      record("removed", `event:${event}`);
    }
    if (extension.handlers.has("tool_call")) {
      if (policy.toolCallHooksDisabled.has(pluginId)) {
        extension.handlers.delete("tool_call");
        record("disabled", "event:tool_call");
      } else {
        wrapToolCallHandlers(extension, pluginId, policy);
      }
    }
    for (const key of extension.shortcuts.keys()) record("unsupported", `shortcut:${key}`);
    for (const name of extension.flags.keys()) record("unsupported", `flag:${name}`);
    for (const type of extension.messageRenderers.keys()) record("unsupported", `message-renderer:${type}`);
    for (const type of extension.entryRenderers?.keys() ?? []) record("unsupported", `entry-renderer:${type}`);
    if (extension.toolRenderers?.length) record("unsupported", "tool-renderer");
    if (extension.markdownTransformer) record("unsupported", "markdown-transformer");
  }

  const runtime = result.runtime;
  const recordFor = (extensionPath: string, subject: string) =>
    audit.push({ pluginId: pluginIdOf(policy, extensionPath), action: "removed", subject });
  for (const item of runtime.pendingProviderRegistrations) recordFor(item.extensionPath, `provider:${item.name}`);
  for (const item of runtime.pendingNativeProviderRegistrations) recordFor(item.extensionPath, `provider:${item.provider.id}`);
  for (const item of runtime.pendingVirtualModelRegistrations) {
    recordFor(item.extensionPath, `model:${item.definition.provider}/${item.definition.id}`);
  }
  runtime.pendingProviderRegistrations = [];
  runtime.pendingNativeProviderRegistrations = [];
  runtime.pendingVirtualModelRegistrations = [];
  // MCP 声明在这里只进审计;P5.8b 起改登记到应用的 MCP 列表(D13)。
  for (const server of runtime.mcpServers.list()) {
    recordFor(server.extensionPath, `mcp:${server.name}`);
    runtime.mcpServers.unregister(server.name, server.extensionPath);
  }
  return { result, audit };
}

// ---- 运行期 ----

/** 会话建好之后调用一次(bindCore 已经把 pi 的动作装进共享 runtime,这里覆盖保留域的入口)。 */
export function guardPiPluginRuntime(result: LoadExtensionsResult, policy: PiPluginPolicy): void {
  const runtime: ExtensionRuntime = result.runtime;
  const removed = (extensionPath: string | undefined, subject: string) =>
    policy.onAudit({ pluginId: pluginIdOf(policy, extensionPath), action: "removed", subject });

  runtime.registerProvider = (name, _config, extensionPath) => removed(extensionPath, `provider:${name}`);
  runtime.registerNativeProvider = (provider, extensionPath) => removed(extensionPath, `provider:${provider.id}`);
  runtime.unregisterProvider = (name, extensionPath) => removed(extensionPath, `provider:${name}`);
  runtime.registerVirtualModel = (definition, extensionPath) =>
    removed(extensionPath, `model:${definition.provider}/${definition.id}`);
  runtime.unregisterVirtualModel = (provider, id) => removed(undefined, `model:${provider}/${id}`);
  runtime.mcpServers.register = (server) => removed(server.extensionPath, `mcp:${server.name}`);
  runtime.mcpServers.unregister = (name, extensionPath) => removed(extensionPath, `mcp:${name}`);
  // 模型与思考档位归助手设置(每轮按授权重设);pi 的这两个动作不带调用方,认领不到插件。
  runtime.setModel = async () => {
    removed(undefined, "set-model");
    return false;
  };
  runtime.setThinkingLevel = () => removed(undefined, "set-thinking-level");

  // 运行期 registerTool 写进扩展的工具表后调 refreshTools:先过同一套工具规则再交回 pi。
  const refreshTools = runtime.refreshTools;
  runtime.refreshTools = () => {
    for (const extension of result.extensions) {
      const pluginId = pluginIdOf(policy, extension.path);
      for (const name of [...extension.tools.keys()]) {
        if (isReservedToolName(name, policy.appToolNames)) {
          policy.onAudit({ pluginId, action: "removed", subject: `tool:${name}` });
        }
        extension.tools.delete(name);
      }
    }
    refreshTools();
  };
}

/** session_start 之后调用:插件在 session_start 里补登记的 tool_call 处理函数、保留事件与保留指令,按加载期规则补裁。 */
export function arbitrateLatePiRegistrations(result: LoadExtensionsResult, policy: PiPluginPolicy): void {
  for (const extension of result.extensions) {
    const pluginId = pluginIdOf(policy, extension.path);
    for (const name of [...extension.commands.keys()]) {
      if (!isReservedCommand(name)) continue;
      extension.commands.delete(name);
      policy.onAudit({ pluginId, action: "removed", subject: `command:${name}` });
    }
    for (const event of RESERVED_EVENTS) {
      if (!extension.handlers.delete(event)) continue;
      policy.onAudit({ pluginId, action: "removed", subject: `event:${event}` });
    }
    if (!extension.handlers.has("tool_call")) continue;
    if (policy.toolCallHooksDisabled.has(pluginId)) extension.handlers.delete("tool_call");
    else wrapToolCallHandlers(extension, pluginId, policy);
  }
}

/** 审计 → 错误中心(info 级,只进错误中心不弹提示)。插件页(P6)落地前,用户在这里看到「插件的哪部分没生效、为什么」。 */
export function piPluginAuditReport(record: PiPluginAuditRecord): EngineErrorReport {
  const plugin = record.pluginId || "?";
  return {
    domain: "pi-engine",
    severity: "info",
    message: `插件裁决:${plugin} ${record.action} ${record.subject}${record.detail ? `(${record.detail})` : ""}`,
    code: `pi_plugin_${record.action}`,
    params: { plugin, subject: record.subject, ...(record.detail ? { detail: record.detail } : {}) },
  };
}
