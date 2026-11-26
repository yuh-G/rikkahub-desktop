// tools/permission.ts — 工具权限按类别判定(方案 §5.6)
//
// 判定只读「类别 + 对象」,不认工具名:工具名 → 类别 + 对象的知识在映射表里(应用工具的表是
// tools/tool-categories.ts)。本模块是纯函数;应用设置(工作区档位、MCP 逐工具设置)由
// tools/approval.ts 解析成 PermissionPolicy 传入。
//
// 写入 / 执行两类走工作区三档矩阵(2026-08-01 用户拍板):
//   confirm_each(询问批准):恒审批;
//   balanced(默认权限):区内写入免审(类比安卓 /tmp 豁免),区外写入审批;执行只在危险命令时审批;
//   full_access(完全访问):全部免审,不受限制操作电脑文件(boundary.ts 对宽界写入不设黑名单)。
// 两段式:参数未到(流式建卡)时请求不带对象,得到的是无参数下界;参数齐备后带对象,得到终局。
// 单调性是硬前提:下界为待审批的组合终局必为待审批,卡永不 pending→auto 降级——不带对象时只有
// confirm_each 的写入 / 执行是待审批,而它不看对象。
// 词法判定看不出的逃逸(软链指向区外等)不产生审批漏洞:未经批准的执行走严界(boundary.ts
// realpath 断言),照样被拒。
//
// 第三方工具(MCP、插件)按模式分治(D32):工作区会话只看档位——confirm_each 询问,另两档不问(应用不认得
// 它们的参数,「区外写入、危险命令」那套套不上);对话模式没有档位,MCP 看逐工具的 needsApproval。插件工具
// 只在工作区会话里出现。会话级「总是允许」对两类都先放行。

import type { WorkspacePermissionPreset } from "../foundation/types";
import { resolveToCwd } from "../../pi/packages/coding-agent/src/core/tools/path-utils.ts";
import { findDangerousCommandReason, isLexicallyOutsideRoot } from "../workspace/approval";

/** read 读文件 / 搜索 / 列目录;write 改文件;execute 跑命令;network 联网搜索与抓取;mcp MCP 工具;
 *  plugin 插件登记的工具;ask 向用户提问;local 应用自己的功能(记忆、时间、剪贴板、朗读、技能读取),
 *  各由自己的设置把关,不挂审批。 */
export type ToolCategory = "read" | "write" | "execute" | "network" | "mcp" | "plugin" | "ask" | "local";

/** 操作对象的原值。路径相对会话工作目录的解析在判定处做,与执行内核(pi 内建工具)同一函数(含 ~ 展开),
 *  审批眼中的目标与实际写入目标一致。 */
export interface PermissionTarget {
  path?: string;
  command?: string;
  url?: string;
}

export interface PermissionRequest {
  conversationId: string;
  toolName: string;
  category: ToolCategory;
  /** 缺省 = 参数还没到(流式建卡)。 */
  target?: PermissionTarget;
  origin: { kind: "app" | "engine" | "plugin"; pluginId?: string };
}

export interface WorkspacePolicy {
  preset: WorkspacePermissionPreset;
  /** 工作区边界根(绝对路径)。 */
  root: string;
  /** 会话工作目录(相对路径按此解析,恒在 root 内)。 */
  cwd: string;
  /** 免审批可写前缀(§6.7,对齐 APP「/skills 加入免审批可写区」):balanced 档写入落在这些目录内,
   *  即便越出工作区边界根也免审。只作用于写入;执行仍只看危险命令;confirm_each 不受影响。 */
  exemptWritePrefixes: readonly string[];
}

/** 判定要用的应用设置,按类别只填用得到的部分。 */
export interface PermissionPolicy {
  /** 写入 / 执行类,以及工作区会话里的 MCP / 插件类。null = 会话没绑工作区(对话模式):写入 / 执行两类工具
   *  不会挂载,残留调用由执行层拒绝,不挂审批。 */
  workspace?: WorkspacePolicy | null;
  /** MCP 类,只在对话模式用:该工具对当前助手生效的 needsApproval(助手级覆盖优先,否则全局逐工具设置)。 */
  mcpApprovalRequired?: boolean;
  /** MCP / 插件类:用户在本会话的审批卡上选过「此会话内总是允许该工具」。 */
  allowedForSession?: boolean;
}

export type PermissionDecision = { type: "auto" } | { type: "pending"; reason?: string };

const AUTO: PermissionDecision = { type: "auto" };

function pending(reason?: string): PermissionDecision {
  return reason ? { type: "pending", reason } : { type: "pending" };
}

function workspaceDecision(req: PermissionRequest, workspace: WorkspacePolicy | null): PermissionDecision {
  if (!workspace || workspace.preset === "full_access") return AUTO;
  if (workspace.preset === "confirm_each") return pending();
  if (req.category === "execute") {
    const reason = findDangerousCommandReason(req.target?.command ?? "");
    return reason ? pending(`Destructive command pattern: ${reason}`) : AUTO;
  }
  // 形状残缺(path 缺失)不挂审批,交给内核按 schema 报错回灌模型。
  const raw = req.target?.path;
  if (typeof raw !== "string" || !raw.trim()) return AUTO;
  const resolved = resolveToCwd(raw, workspace.cwd);
  if (workspace.exemptWritePrefixes.some((prefix) => !isLexicallyOutsideRoot(resolved, prefix))) return AUTO;
  return isLexicallyOutsideRoot(resolved, workspace.root) ? pending(`Writes outside the workspace: ${resolved}`) : AUTO;
}

/** 工作区会话里的第三方工具。缺工作区按最严档(插件工具正常不会出现在没有工作区的会话里)。 */
function thirdPartyDecision(policy: PermissionPolicy): PermissionDecision {
  if (policy.allowedForSession) return AUTO;
  return !policy.workspace || policy.workspace.preset === "confirm_each" ? pending() : AUTO;
}

/** 一次工具调用要不要先问用户。pending 的 reason 是给审批卡的缘由(英文,与工具错误文案同语言),
 *  缺省 = 档位或类别本身要求逐项确认。 */
export function decidePermission(req: PermissionRequest, policy: PermissionPolicy): PermissionDecision {
  switch (req.category) {
    case "read":
    case "network":
    case "local":
      return AUTO;
    case "ask":
      return pending();
    case "plugin":
      return thirdPartyDecision(policy);
    case "mcp":
      if (policy.workspace) return thirdPartyDecision(policy);
      return policy.mcpApprovalRequired ? pending() : AUTO;
    case "write":
    case "execute":
      return workspaceDecision(req, policy.workspace ?? null);
  }
}
