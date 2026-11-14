// workspace/runtime.ts — 工作区运行时:shell 探针 + 会话 → 工作区解析
// 工作区工具 P4b 起由引擎自带(pi 内建工具定义 + 应用后端,pi-engine/builtin-tools.ts):路径边界在 ./boundary.ts,
// 命令执行后端在 ./tools/bash.ts,审批按类别在 tools/permission.ts。本模块只回答两件事:这台机器有没有可用的
// bash(决定挂哪组工具),这个会话能不能用它绑定的工作区(决定生成路由到哪个引擎,engines/index.ts)。

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Conversation, Workspace } from "../foundation/types";
import { state } from "../persistence/json-store";
import { getWorkspace, workspaceStatus } from "./index";
import { assertInsideWorkspace } from "./boundary";
import { getShellConfig, resetShellConfigCache } from "./tools/shell";

// ----- shell 可用性探针(进程级缓存;Windows 无 Git Bash → bash 工具不挂载,§5.1) -----

let shellProbe: { available: boolean; shell?: string; error?: string } | null = null;

/** shell 是探测到的 bash 路径(available 时必有),工作区引擎经契约 EngineWorkspace.shell 拿到它。 */
export function shellAvailability(): { available: boolean; shell?: string; error?: string } {
  if (!shellProbe) {
    try {
      // 空串 → undefined 走自动探测;非空 = 用户显式指定的 bash 路径(最高优先级)。
      // state?. 可选链对齐 workspace/index.ts 范式:测试/未初始化时 state 为空,取 undefined。
      shellProbe = { available: true, shell: getShellConfig(state?.settings?.shellPath || undefined).shell };
    } catch (err) {
      shellProbe = { available: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return shellProbe;
}

/** 用户装完 Git Bash 后从 UI 触发重探;单测亦用。shell.ts 的验证缓存一并清。 */
export function refreshShellAvailability(): void {
  shellProbe = null;
  resetShellConfigCache();
}

// ----- 会话 → 工作区运行时解析 -----

export interface WorkspaceRuntime {
  workspace: Workspace;
  /** 边界根(绝对路径) */
  root: string;
  /** 会话工作目录(恒在 root 边界内;丢失时自愈回 root) */
  cwd: string;
}

/** 会话可用工作区的三道闸:存在、根目录健在、已过信任门。 */
function workspaceUsable(workspace: Workspace | null): workspace is Workspace {
  if (!workspace || workspaceStatus(workspace) === "missing") return false;
  return !(workspace.type === "folder" && workspace.trustedAt == null);
}

function resolveCwd(workspace: Workspace, workspaceCwd: string | null | undefined): string {
  const raw = String(workspaceCwd ?? "").trim();
  if (!raw) return workspace.root;
  // 契约上 workspaceCwd 是边界内绝对路径;相对值按 root 解析(容错导入数据)。
  const absolute = isAbsolute(raw) ? raw : resolve(workspace.root, raw);
  try {
    const safe = assertInsideWorkspace(absolute, workspace.root);
    // cwd 目录被(agent 自己)删掉后自愈回 root,而不是让后续所有工具报错。
    return existsSync(safe) ? safe : workspace.root;
  } catch {
    return workspace.root;
  }
}

/** 会话能用的工作区(静默):不可用返回 null,不抛——每轮生成的路由热路径上调用。 */
export function workspaceRuntimeForConversation(
  conversation: Pick<Conversation, "workspaceId" | "workspaceCwd"> | null | undefined,
): WorkspaceRuntime | null {
  const workspaceId = conversation?.workspaceId;
  if (!workspaceId) return null;
  const workspace = getWorkspace(workspaceId);
  if (!workspaceUsable(workspace)) return null;
  return { workspace, root: workspace.root, cwd: resolveCwd(workspace, conversation?.workspaceCwd) };
}
