// pi-engine/plugins/arbiter.ts — 插件裁决层(方案 §5.5「P5.0 定稿」;资源加载器的 extensionsOverride 接在这里)
//
// 裁决只针对插件经 pi 接口登记的东西,插件自身的代码不管(D6)。两种时机:
// - 加载期(arbitratePiExtensions):与本轮应用工具 / pi 内建工具同名、以 mcp__ 开头的工具,入口类指令名,
//   保留事件的处理函数,排队中的供应商 / 虚拟模型 / MCP 登记,都拿掉;终端界面类登记记「不支持」;
//   其余插件工具包上执行前审批(P5.4,类别 plugin,经应用审批流程,来源带插件 id)后进会话;
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

import { AsyncLocalStorage } from "node:async_hooks";
import type {
  Extension,
  ExtensionContext,
  ExtensionRuntime,
  ExtensionUIContext,
  LoadExtensionsResult,
  RegisteredTool,
  ToolCallEvent,
  ToolCallEventResult,
  ToolDefinition,
} from "../../../pi/packages/coding-agent/src/core/extensions/types.ts";
import { allToolNames } from "../../../pi/packages/coding-agent/src/core/tools/index.ts";
import type { EngineErrorReport } from "../../engines/contract";
import { markToolGated } from "../tool-gate";
import { pluginIdForExtensionPath, type PiPluginEntry } from "./entries";

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

export interface PiPluginAuditRecord {
  /** 空串 = 认领不到插件(pi 的 setModel / setThinkingLevel 不带调用方)。 */
  pluginId: string;
  /** removed = 保留域或重名,拿掉;unsupported = 登记留着但不会生效;disabled = 按手动开关停用;
   *  discarded = 处理期间弹了对话框,这次裁决作废;vetoed = 没弹窗的否决,已生效。 */
  action: "removed" | "unsupported" | "disabled" | "discarded" | "vetoed";
  /** removed / unsupported / disabled:tool:<名>、command:<名>、event:<名>、provider:<id>、model:<供应商>/<id>、
   *  mcp:<名>、set-model、set-thinking-level、指令里的会话管理动作(new-session / fork / navigate-tree /
   *  switch-session / reload)、shortcut / flag / *-renderer…;discarded / vetoed:工具名。 */
  subject: string;
  /** vetoed:插件给的理由。 */
  detail?: string;
}

export interface PiPluginToolApproval {
  toolCallId: string;
  toolName: string;
  pluginId: string;
}

/** 放行时兑现(放行结果对插件工具没有意义,不读);拒绝 / 中止时以错误拒绝,错误文本即给模型的工具结果。 */
export type PiPluginToolApprover = (req: PiPluginToolApproval) => Promise<unknown>;

export interface PiPluginPolicy {
  entries: readonly PiPluginEntry[];
  /** 本轮应用工具名:插件工具与之同名即拿掉。 */
  appToolNames: ReadonlySet<string>;
  /** 用户手动停用了工具调用钩子的插件 id(D7 的兜底开关)。 */
  toolCallHooksDisabled: ReadonlySet<string>;
  /** 插件 id → 用户逐个关掉的工具名(插件页的逐工具开关)。不给 = 全部启用。 */
  toolsDisabled?: ReadonlyMap<string, ReadonlySet<string>>;
  /** 插件工具执行前的应用审批(生产 = host.permission.check)。不给 = 插件工具不进会话(压缩会话不执行工具)。 */
  approveTool?: PiPluginToolApprover;
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

/** 插件不能用的指令名 = 入口类(通往应用资产的入口,谁来做都一样;方案 §5.9 D17)。pi 内建指令名逐个归类:
 *  入口类在这里,能力类在 PI_RELEASED_COMMANDS(放开给插件,与应用的同名通用指令并列显示)。pi 升级新增的
 *  内建名必须二选一(arbiter.test 锁定)。 */
export const PI_RESERVED_COMMANDS: ReadonlySet<string> = new Set([
  "settings", "model", "scoped-models", "thinking", "new", "resume", "fork", "clone", "tree", "name",
  "import", "login", "logout", "trust", "reload", "quit", "mcp", "skill",
]);

export const PI_RELEASED_COMMANDS: ReadonlySet<string> = new Set(["compact", "export", "share", "copy", "session", "bug", "changelog", "hotkeys"]);

export const isReservedPiCommand = (name: string) => PI_RESERVED_COMMANDS.has(name) || name.startsWith("skill:");

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

/** 正在执行的插件代码属于哪个插件(插件工具的执行、tool_call 处理函数),界面请求据此署名。 */
const pluginScope = new AsyncLocalStorage<string>();

/** 当前调用链所属的插件 id;认领不到(插件在别的事件里调用界面)时为 undefined。 */
export function activePiPluginId(): string | undefined {
  return pluginScope.getStore();
}

/** 以某个插件的名义执行它的代码(插件指令的处理函数),界面请求与审计据此署名。 */
export function runAsPiPlugin<T>(pluginId: string, fn: () => T): T {
  return pluginScope.run(pluginId, fn);
}

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
 *  界面桥(ui-bridge)绑进会话前必须先经过它。 */
export function guardPiPluginDialogs(ui: ExtensionUIContext): ExtensionUIContext {
  return dialogGuard(ui, () => toolCallScope.getStore());
}

function replaceContents(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(target)) if (!(key in source)) delete target[key];
  Object.assign(target, source);
}

/** 生效的否决,按工具调用 id 等事件桥在这次调用结束时取走(工具卡署名「被插件 X 拒绝」,D14)。插件另开的子会话
 *  没有事件桥来取,所以有上限,超出丢最早的。 */
const vetoes = new Map<string, { pluginId: string; reason: string }>();
const MAX_PENDING_VETOES = 100;

export function takePiPluginVeto(toolCallId: string): { pluginId: string; reason: string } | undefined {
  const veto = vetoes.get(toolCallId);
  vetoes.delete(toolCallId);
  return veto;
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
      verdict = await pluginScope.run(pluginId, () => toolCallScope.run(probe, () => hook(draft, tagged)));
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
    vetoes.set(event.toolCallId, { pluginId, reason });
    if (vetoes.size > MAX_PENDING_VETOES) vetoes.delete(vetoes.keys().next().value!);
    return { ...result, reason: `Blocked by plugin "${pluginId}": ${reason}` };
  };
}

const ARBITRATED = Symbol("rikkahub.arbitrated");

type Marked = { [ARBITRATED]?: true };

/** 插件工具进会话前包一层执行前审批(类别 plugin,经应用的审批流程)。同一个定义只包一次。 */
function gatePluginTool(tool: RegisteredTool, pluginId: string, approve: PiPluginToolApprover): void {
  const definition = tool.definition;
  if ((definition as Marked)[ARBITRATED]) return;
  const gated: ToolDefinition = {
    ...definition,
    // 与应用工具同为顺序执行:审批卡逐个弹(并行批里的多张待审卡会互相覆盖会话的等待态)。
    executionMode: "sequential",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      await approve({ toolCallId, toolName: definition.name, pluginId });
      return pluginScope.run(pluginId, () => definition.execute(toolCallId, params, signal, onUpdate, ctx));
    },
  };
  tool.definition = markToolGated(Object.assign(gated, { [ARBITRATED]: true as const }));
}

/** 工具规则:保留名拿掉、用户关掉的停用,都记审计;没有审批口(压缩会话)时一律不进会话;其余包上执行前审批。 */
function arbitrateTools(
  extension: Extension,
  pluginId: string,
  policy: PiPluginPolicy,
  onAudit: (record: PiPluginAuditRecord) => void,
): void {
  for (const [name, tool] of [...extension.tools]) {
    if (isReservedToolName(name, policy.appToolNames)) {
      extension.tools.delete(name);
      onAudit({ pluginId, action: "removed", subject: `tool:${name}` });
    } else if (policy.toolsDisabled?.get(pluginId)?.has(name)) {
      extension.tools.delete(name);
      onAudit({ pluginId, action: "disabled", subject: `tool:${name}` });
    } else if (!policy.approveTool) {
      extension.tools.delete(name);
    } else {
      gatePluginTool(tool, pluginId, policy.approveTool);
    }
  }
}

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

    arbitrateTools(extension, pluginId, policy, (item) => audit.push(item));
    for (const name of [...extension.commands.keys()]) {
      if (!isReservedPiCommand(name)) continue;
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
  // MCP 归应用(D13):加载期的这批声明由应用在安装 / 重装时读出并登记进自己的 MCP 列表(engines/plugin-mcp),
  // 会话里只拿掉并记审计;会话建好后才登记的不收集。
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
    for (const extension of result.extensions) arbitrateTools(extension, pluginIdOf(policy, extension.path), policy, policy.onAudit);
    refreshTools();
  };
}

/** session_start 之后调用:插件在 session_start 里补登记的 tool_call 处理函数、保留事件与保留指令,按加载期规则补裁。 */
export function arbitrateLatePiRegistrations(result: LoadExtensionsResult, policy: PiPluginPolicy): void {
  for (const extension of result.extensions) {
    const pluginId = pluginIdOf(policy, extension.path);
    for (const name of [...extension.commands.keys()]) {
      if (!isReservedPiCommand(name)) continue;
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
