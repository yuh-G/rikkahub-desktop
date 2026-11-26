// api/router.ts — API 路由调度表（原 server.ts routeApi()，106 个分支已按领域拆至 handlers/）
// 纪律：调度顺序与拆分前 routeApi 的分支求值顺序一致；跨领域匹配器不相交（exact 路径互斥、
// regex 带 method 门控），领域内严格保序 → 行为不变。

import { JsonBodyError, error } from "./request";
import { handleCommandRoutes } from "./handlers/commands";
import { handleConversationRoutes } from "./handlers/conversations";
import { handleDataRoutes } from "./handlers/data";
import { handleErrorRoutes } from "./handlers/errors";
import { handleFileRoutes } from "./handlers/files";
import { handleMediaRoutes } from "./handlers/media";
import { handleMemoryRoutes } from "./handlers/memory";
import { handlePluginRoutes } from "./handlers/plugins";
import { handleSettingsRoutes } from "./handlers/settings";
import { handleSkillRoutes } from "./handlers/skills";
import { handleSystemRoutes } from "./handlers/system";
import { handleUpdateRoutes } from "./handlers/update";
import { handleWorkspaceRoutes } from "./handlers/workspaces";

const handlers = [
  handleSystemRoutes,
  handleSettingsRoutes,
  handleMemoryRoutes,
  handleCommandRoutes,
  handleConversationRoutes,
  handleWorkspaceRoutes,
  handleFileRoutes,
  handleSkillRoutes,
  handlePluginRoutes,
  handleDataRoutes,
  handleUpdateRoutes,
  handleMediaRoutes,
  handleErrorRoutes,
] as const;

export async function routeApi(request: Request, url: URL) {
  const path = url.pathname.replace(/^\/api\/?/, "");
  for (const handler of handlers) {
    let response: Response | null;
    try {
      response = await handler(request, url, path);
    } catch (err) {
      if (err instanceof JsonBodyError) return error("Malformed JSON body", 400);
      throw err;
    }
    if (response) return response;
  }
  console.warn(`[404] ${request.method} /api/${path}`);
  return error("Not found", 404);
}
