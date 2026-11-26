// api/handlers/workspaces.ts — 工作区路由(agent 模式,§5.4)
// CRUD + 信任门确认。工具执行/文件面板路由随 M1-4/M3 加入。

import type { Workspace } from "../../foundation/types";
import type { WorkspaceDto } from "../../foundation/types/dto";
import { createWorkspace, deleteWorkspace, getWorkspace, listWorkspaces, trustWorkspace, updateWorkspace, workspaceStatus } from "../../workspace";
import { deleteWorkspaceEntry, listWorkspaceDir, previewWorkspaceFile, readWorkspaceAgentsFile, renameWorkspaceEntry, revealWorkspaceEntry, writeWorkspaceAgentsFile } from "../../workspace/files";
import { refreshShellAvailability, shellAvailability } from "../../workspace/runtime";
import { piBuiltinToolNames } from "../../pi-engine/builtin-tools";
import { error, json, readJson } from "../request";

export function shellStatusPayload(): { available: boolean; error: string | null; mountedTools: string[] } {
  const shell = shellAvailability();
  return { available: shell.available, error: shell.error ?? null, mountedTools: piBuiltinToolNames(shell.shell) };
}

function toDto(workspace: Workspace): WorkspaceDto {
  return { ...workspace, status: workspaceStatus(workspace) };
}

export async function handleWorkspaceRoutes(request: Request, _url: URL, path: string): Promise<Response | null> {
  if (path === "workspaces" && request.method === "GET") {
    return json({ workspaces: listWorkspaces().map(toDto) });
  }

  if (path === "workspaces" && request.method === "POST") {
    const body = await readJson<{ type?: string; name?: string; root?: string }>(request);
    const type = String(body.type ?? "");
    if (type !== "managed" && type !== "folder") return error("type must be managed or folder", 400);
    try {
      return json({ workspace: toDto(createWorkspace({ type, name: body.name, root: body.root })) });
    } catch (err) {
      return error(err instanceof Error ? err.message : "创建工作区失败", 400);
    }
  }

  // ---- shell 探测状态(K3):bash 不可用时前端引导安装 Git;装完后可触发重探 ----
  // 注意置于 :id 正则之前,否则 shell-status 会被吞成工作区 id。
  if (path === "workspaces/shell-status" && request.method === "GET") {
    return json({ shell: shellStatusPayload() });
  }
  if (path === "workspaces/shell-status/refresh" && request.method === "POST") {
    refreshShellAvailability();
    return json({ shell: shellStatusPayload() });
  }

  const workspaceRoute = path.match(/^workspaces\/([^/]+)(?:\/(.*))?$/);
  if (!workspaceRoute) return null;
  const workspaceId = decodeURIComponent(workspaceRoute[1]);
  const sub = workspaceRoute[2] ?? "";

  if (!sub && request.method === "GET") {
    const workspace = getWorkspace(workspaceId);
    if (!workspace) return error("Workspace not found", 404);
    return json({ workspace: toDto(workspace) });
  }

  if (!sub && request.method === "PATCH") {
    // B6-①b:root 仅 folder 型可重绑(校验+信任门重置在领域层),managed 型传 root 会抛错。
    const body = await readJson<{ name?: string; permissionPreset?: string; root?: string }>(request);
    try {
      const updated = updateWorkspace(workspaceId, body);
      if (!updated) return error("Workspace not found", 404);
      return json({ workspace: toDto(updated) });
    } catch (err) {
      return error(err instanceof Error ? err.message : "更新工作区失败", 400);
    }
  }

  // ---- 文件面板路由(M3-5,§4.4):path 参数为相对 root 的路径,边界断言在领域层 ----
  if (sub === "files" || sub.startsWith("files/")) {
    const workspace = getWorkspace(workspaceId);
    if (!workspace) return error("Workspace not found", 404);
    const relPath = _url.searchParams.get("path") ?? "";
    try {
      if (sub === "files" && request.method === "GET") {
        return json({ entries: listWorkspaceDir(workspace, relPath) });
      }
      if (sub === "files/content" && request.method === "GET") {
        return json({ preview: await previewWorkspaceFile(workspace, relPath) });
      }
      if (sub === "files/rename" && request.method === "POST") {
        const body = await readJson<{ path?: string; newName?: string }>(request);
        renameWorkspaceEntry(workspace, String(body.path ?? ""), String(body.newName ?? ""));
        return new Response(null, { status: 204 });
      }
      if (sub === "files" && request.method === "DELETE") {
        deleteWorkspaceEntry(workspace, relPath);
        return new Response(null, { status: 204 });
      }
      if (sub === "files/reveal" && request.method === "POST") {
        const body = await readJson<{ path?: string }>(request);
        revealWorkspaceEntry(workspace, String(body.path ?? ""));
        return new Response(null, { status: 204 });
      }
      return null;
    } catch (err) {
      return error(err instanceof Error ? err.message : "文件操作失败", 400);
    }
  }

  // ---- AGENTS.md 编辑入口(P4,§3.3):读写 pi 实际加载的项目上下文文件 ----
  if (sub === "agents-file") {
    const workspace = getWorkspace(workspaceId);
    if (!workspace) return error("Workspace not found", 404);
    try {
      if (request.method === "GET") {
        return json({ agentsFile: readWorkspaceAgentsFile(workspace) });
      }
      if (request.method === "PUT") {
        const body = await readJson<{ content?: string }>(request);
        return json({ agentsFile: writeWorkspaceAgentsFile(workspace, String(body.content ?? "")) });
      }
      return null;
    } catch (err) {
      return error(err instanceof Error ? err.message : "AGENTS.md 操作失败", 400);
    }
  }

  if (sub === "trust" && request.method === "POST") {
    const trusted = trustWorkspace(workspaceId);
    if (!trusted) return error("Workspace not found", 404);
    return json({ workspace: toDto(trusted) });
  }

  if (!sub && request.method === "DELETE") {
    if (!deleteWorkspace(workspaceId)) return error("Workspace not found", 404);
    return new Response(null, { status: 204 });
  }

  return null;
}
