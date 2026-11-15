// api/handlers/commands.ts — 斜杠指令:可用清单与引擎特色指令的执行
//
// GET /api/commands?conversationId=xxx
// 服务端是可用性的唯一权威(引擎路由判定材料在服务端;方案 §3.3):前端只消费
// 清单做补全/染色/拦截,不得自行判定。会话不存在(新会话未落库/已删除)返回空
// 清单——没有会话就没有指令作用对象,指令面整体关闭,与"禁用即不存在"同语义。
// 清单 = 通用指令 + 会话引擎的特色指令(commands/registry 的 mergeEngineCommands 合并,每条带来源)。
//
// POST /api/commands/run { conversationId, commandId, args? }
// 执行一条引擎特色指令(commandId 取自清单)。执行完才返回;处理函数要模型再答的那一轮随后由应用开轮,
// 经会话流推送。生成或压缩进行中 → 409 command_busy。

import { getConversation } from "../../conversations";
import { listEngineCommands, resolveEngineForConversation, runEngineCommand } from "../../conversations/orchestrator";
import { checkoutConversation, releaseConversation } from "../../conversations/working-set";
import { mergeEngineCommands } from "../../commands/registry";
import { CodedError } from "../../foundation/errors";
import { reportError } from "../../observability/app-errors";
import { error, json, readJson } from "../request";

/** 与入口类同名而被拿掉的插件指令,同一条只记一次审计(清单每次切会话都会取)。 */
const reportedRemovals = new Set<string>();

export async function handleCommandRoutes(request: Request, url: URL, path: string): Promise<Response | null> {
  if (path === "commands" && request.method === "GET") {
    const conversationId = url.searchParams.get("conversationId") ?? "";
    const conversation = conversationId ? getConversation(conversationId) : null;
    if (!conversation) return json({ commands: [] });
    const engineKind = resolveEngineForConversation(conversation).kind;
    const { commands: engineCommands } = await listEngineCommands(conversation);
    const { commands, removed } = mergeEngineCommands(engineKind, engineCommands);
    for (const command of removed) {
      const key = `${command.source}|${command.name}`;
      if (reportedRemovals.has(key)) continue;
      reportedRemovals.add(key);
      reportError("internal", "info", `指令 /${command.name}(${command.source})与应用的入口类指令同名,已拿掉`, undefined, "plugin_command_removed", {
        source: command.source,
        name: command.name,
      });
    }
    return json({ commands });
  }
  if (path === "commands/run" && request.method === "POST") {
    const body = await readJson<{ conversationId?: string; commandId?: string; args?: string }>(request);
    const conversation = getConversation(String(body.conversationId ?? ""));
    if (!conversation) return error("Conversation not found", 404);
    const commandId = String(body.commandId ?? "");
    if (!commandId) return error("commandId is required", 400);
    checkoutConversation(conversation.id);
    try {
      await runEngineCommand(conversation, commandId, String(body.args ?? "").trim());
      return json({ status: "done" });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return json({ status: "aborted" });
      if (err instanceof CodedError && err.errorCode === "command_busy") return error(err.message, 409, err.errorCode);
      const errorCode = err instanceof CodedError ? err.errorCode : undefined;
      return error(err instanceof Error ? err.message : String(err), 400, errorCode);
    } finally {
      releaseConversation(conversation.id);
    }
  }
  return null;
}
