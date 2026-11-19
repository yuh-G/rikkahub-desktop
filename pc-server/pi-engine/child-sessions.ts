// pi-engine/child-sessions.ts — 插件另开的 pi 会话(子代理插件)的工具调用约束(P5.9,原型 X5 的结论)
//
// 子代理插件在进程内另建 AgentSession 跑子任务。插件经加载器的虚拟模块拿到的就是应用用的这份 pi,同一个
// AgentSession 类;这些会话的工具是 pi 默认后端(没有工作区边界、不过应用审批、不带闸门标记)。
// 约束挂在 AgentSession 原型的工具调用前钩子 _beforeToolCall 上(每个会话的每次调用、含工具里的嵌套调用都经过它),
// 先跑 pi 原有流程(插件的 tool_call 钩子),没被否决再看工具:
// - 带闸门标记的(应用建的会话;插件把父会话的工具交给子会话):原样放行,审批在它的 execute 里。
// - 没带标记、名字是 pi 内建工具的(插件另开的会话里的 read / bash / edit / write…):按钩子改过的最终参数,经发起
//   这一轮的审批口判定(来源 engine,noPrompt——子会话的调用在父会话里没有工具卡,需要用户确认的直接拒绝)。
//   放行范围是 default 时补上应用后端的严界:写入按真实路径校验在工作区边界内,危险命令不执行。
// - 其余(插件自己登记的工具)是插件代码,不另加审批:发起子任务的那个插件工具已经过了审批。
// 发起者经 AsyncLocalStorage 认领:runner 把生成与指令执行包在 runAsPiChildOwner 里,插件在其中另起的会话
// (含转入后台继续跑的)都继承它。认领不到、或这一轮已结束(接线已清空),内建工具一律拒绝。
// 插件以 pi 命令行模式再启动本程序跑后台子任务的做法不支持,入口处拦截(foundation/process-roles.ts)。

import { AsyncLocalStorage } from "node:async_hooks";
import type { BeforeToolCallContext, BeforeToolCallResult } from "../../pi/packages/agent/src/types.ts";
import { AgentSession } from "../../pi/packages/coding-agent/src/core/agent-session.ts";
import type { PermissionGrant } from "../engines/contract";
import type { JsonValue } from "../foundation/types";
import { findDangerousCommandReason } from "../workspace/approval";
import { assertInsideWorkspace } from "../workspace/boundary";
import { piBuiltinToolPermission, type PiBuiltinToolApprover } from "./builtin-tools";
import { isToolGated } from "./tool-gate";

export interface PiChildSessionOwner {
  /** 工作区边界根。 */
  root: string;
  approve: PiBuiltinToolApprover;
}

const owners = new AsyncLocalStorage<PiChildSessionOwner | undefined>();

/** 以某一轮的名义执行(插件在其中另开的会话的工具调用,经这一轮的审批口判定)。owner 缺省 = 这一轮没有
 *  工作区工具,其中另开的会话的内建工具一律拒绝。 */
export function runAsPiChildOwner<T>(owner: PiChildSessionOwner | undefined, fn: () => T): T {
  return owners.run(owner, fn);
}

type BeforeToolCall = (this: AgentSession, context: BeforeToolCallContext, parentToolCallId?: string) => Promise<BeforeToolCallResult | undefined>;

const INSTALLED = Symbol.for("rikkahub.child-session-gate");

interface HookedPrototype {
  _beforeToolCall?: BeforeToolCall;
  [INSTALLED]?: true;
}

const blocked = (reason: string): BeforeToolCallResult => ({ block: true, reason });
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function checkChildToolCall(session: AgentSession, name: string, toolCallId: string, args: Record<string, JsonValue>): Promise<BeforeToolCallResult | undefined> {
  const permission = piBuiltinToolPermission(name, args, session.sessionManager.getCwd());
  if (!permission) return undefined;
  const owner = owners.getStore();
  if (!owner) {
    return blocked(`Tool '${name}' was NOT executed: this session was started by a plugin outside of a workspace turn, so built-in tools are unavailable in it.`);
  }
  let grant: PermissionGrant;
  try {
    grant = await owner.approve({ toolCallId, toolName: name, args, ...permission, noPrompt: true });
  } catch (err) {
    return blocked(messageOf(err));
  }
  if (grant.scope === "unrestricted") return undefined;
  const danger = permission.category === "execute" ? findDangerousCommandReason(permission.target.command ?? "") : null;
  if (danger) {
    return blocked(`Command blocked by safety policy: it matches a destructive pattern (${danger}) and was NOT executed. Ask the user to run it in the main conversation.`);
  }
  if (permission.category === "write" && permission.target.path) {
    try {
      assertInsideWorkspace(permission.target.path, owner.root);
    } catch (err) {
      return blocked(messageOf(err));
    }
  }
  return undefined;
}

/** 装在 AgentSession 原型上,进程内只装一次(本模块加载即装)。 */
export function installPiChildSessionGate(): void {
  const proto = AgentSession.prototype as unknown as HookedPrototype;
  if (proto[INSTALLED]) return;
  const original = proto._beforeToolCall;
  if (typeof original !== "function") throw new Error("pi 的 AgentSession 没有 _beforeToolCall(升级 pi 后改名了?),插件另开的会话无法约束");
  proto._beforeToolCall = async function (context, parentToolCallId) {
    const result = await original.call(this, context, parentToolCallId);
    if (result?.block) return result;
    const name = context.toolCall.name;
    const definition = this.getToolDefinition(name);
    // 没有这个工具:交给 pi 报「找不到工具」。
    if (!definition || isToolGated(definition)) return result;
    return (await checkChildToolCall(this, name, context.toolCall.id, (context.args ?? {}) as Record<string, JsonValue>)) ?? result;
  };
  proto[INSTALLED] = true;
}

installPiChildSessionGate();
