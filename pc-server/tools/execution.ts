// tools/execution.ts — 工具执行调度器（executeToolCall：搜索/技能/本地/记忆/MCP 分发、结果 → UI parts、二进制落盘）
// 纪律：纯搬迁自 server.ts（阶段 5.3e），行为不变。

import { existsSync, readFileSync, statSync } from "node:fs";
import { bumpAnalyticsMcpCount, bumpAnalyticsSearchCount } from "../app-config/analytics";
import { join } from "node:path";
import type { Assistant, JsonValue, MessagePart, StoredFile, ToolOutputEntry } from "../foundation/types";
import type { ToolResult } from "../inference-engine/events";
import { extensionFromMime, getStringArray, isRecord } from "../foundation/utils";
import { filesDir } from "../foundation/paths";
import { saveState, state } from "../persistence/json-store";
import { addLog } from "../api/logs";
import { broadcastMemoryUpdate } from "../api/sse";
import { memoryStore } from "../memory";
import { runScrapeWeb, runSearchWeb } from "../search";
import { callMcpTool, resolveMcpToolServer } from "./mcp";
import { ensureFreshMcpToken } from "./mcp-oauth";
import { mcpToolFailureError } from "./mcp-health";
import { runAskUserTool, runClipboardTool, runGetTimeInfoTool, runTextToSpeechTool } from "./local";
import { readSkillBody, safeSkillFile } from "./skills";
import { isWorkspaceToolName } from "../workspace/approval";
import { runWorkspaceTool } from "../workspace/runtime";

/** save_memory 工具执行(1.3.2)。模型只提议 content,应用按 writeStrategy 决定落地方式:
 *  - always_assistant + 助手层启用 → 直接存助手层
 *  - always_global + 全局层启用 → 直接存全局层
 *  - ask(默认)、或 always_* 但对应层未启用(M3 矛盾组合降级)→ 进待确认队列
 *  ★ 返回值不含 pending: true —— 生成不在此暂停(区别于 ask_user 的审批挂起机制,§6.2)。 */
async function runSaveMemoryTool(
  assistant: Assistant,
  args: Record<string, JsonValue>,
  context?: { conversationId?: string; conversationTitle?: string; messageNodeId?: string },
): Promise<Record<string, JsonValue>> {
  const content = String(args.content ?? "").trim();
  if (!content) throw new Error("content is required");
  const ms = state.settings.memorySettings;
  const strategy = ms.writeStrategy;

  if (strategy === "always_assistant" && assistant.enableMemory) {
    const mem = memoryStore.addMemory({ scope: "assistant", assistantId: assistant.id, content, source: "ai" });
    broadcastMemoryUpdate();
    return { status: "saved", scope: "assistant", content: mem.content };
  }
  if (strategy === "always_global" && ms.globalEnabled) {
    const mem = memoryStore.addMemory({ scope: "global", content, source: "ai" });
    broadcastMemoryUpdate();
    return { status: "saved", scope: "global", content: mem.content };
  }

  // 进待确认队列。context 从 executeToolCall 透传(流式路径含当前会话 + 节点),用于前端确认
  // 面板标注来源会话(标题快照)。非流式路径 context 缺失 → conversationId 留空(仅丧失来源追溯,
  // 不影响核心入队/确认流程)。
  const result = await memoryStore.enqueuePending({
    conversationId: context?.conversationId ?? "",
    conversationTitle: context?.conversationTitle,
    assistantId: assistant.id,
    assistantName: assistant.name,
    content,
    messageNodeId: context?.messageNodeId,
  });
  broadcastMemoryUpdate();
  if (result === null) return { status: "deduped" };       // M7:与现有 pending 完全相同,跳过
  if (result === "overflow") return { status: "overflow" }; // M7:队列已满,徽章变体高亮提醒
  return { status: "queued", pendingId: result.pendingId };
}

export async function executeToolCall(
  toolCall: any,
  assistant: Assistant,
  context?: import("../inference-engine/events").ToolContext,
) {
  const name = String(toolCall.function?.name ?? "");
  let args: Record<string, JsonValue> = {};
  try {
    const parsedArgs = JSON.parse(String(toolCall.function?.arguments ?? "{}").trim() || "{}");
    if (!isRecord(parsedArgs) || Array.isArray(parsedArgs)) {
      throw new Error("tool arguments must be a JSON object");
    }
    args = parsedArgs as Record<string, JsonValue>;
  } catch (err) {
    throw new Error(`Invalid tool arguments JSON for ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (name === "save_memory") return runSaveMemoryTool(assistant, args, context);
  // 工作区工具（pi 移植层）：会话必须绑定工作区，守卫链在 runtime 内（同 search_web
  // 关闭后拒执的语义：历史残留调用招拒绝文案回灌模型）。
  if (isWorkspaceToolName(name)) return runWorkspaceTool(name, args, context);
  // 联网搜索是可关闭的工具(全局 enableWebSearch 开关)。关闭后,tools 数组里不再声明
  // search_web,但历史消息里残留的 search tool_call 仍会诱导模型再次调用——而本函数原本
  // 无条件执行真搜索,造成"关了搜索 AI 照样搜"的 bug。加守卫与 use_skill(6266) /
  // callMcpTool(5912) 的"本轮未启用则拒绝执行"语义对齐(安卓等价:未注册到本轮 tools 表
  // 的工具根本查不到 execute)。throw 经调用方 catch 转成 tool_result 回灌,模型看到
  // "已禁用"即停止。
  if (name === "search_web") {
    if (!state.settings.enableWebSearch) {
      throw new Error(
        "Web search is currently disabled. Stop calling search_web and answer from your own knowledge, or ask the user to re-enable web search.",
      );
    }
    bumpAnalyticsSearchCount();
    return runSearchWeb(args);
  }
  if (name === "scrape_web") {
    if (!state.settings.enableWebSearch) {
      throw new Error("Web search is currently disabled. Stop calling scrape_web.");
    }
    bumpAnalyticsSearchCount();
    return runScrapeWeb(args);
  }
  if (name === "get_time_info") return runGetTimeInfoTool();
  if (name === "clipboard_tool") return runClipboardTool(args);
  if (name === "text_to_speech") return runTextToSpeechTool(args);
  if (name === "ask_user") return runAskUserTool(args);
  if (name === "use_skill") {
    const skillName = String(args.name ?? "").trim();
    if (!getStringArray(assistant.enabledSkills).includes(skillName)) {
      throw new Error(`Skill '${skillName}' is not available. Available skills: ${getStringArray(assistant.enabledSkills).join(", ")}`);
    }
    const path = String(args.path ?? "").trim();
    const content = path ? (() => {
      const target = safeSkillFile(skillName, path);
      if (!target || !existsSync(target)) throw new Error(`File '${path}' not found in skill '${skillName}'`);
      return readFileSync(target, "utf8");
    })() : readSkillBody(skillName);
    if (!content) throw new Error(`Skill '${skillName}' not found`);
    return { name: skillName, content };
  }
  if (name.startsWith("mcp__")) {
    bumpAnalyticsMcpCount();
    // 专题9 MCP OAuth 2.1 + D13(复查):调用前只补新"目标服务器"的临期令牌——旧实现
    // 串行刷全部服务器,一个坏端点的网络超时会拖慢所有无关工具调用。刷新结果写回
    // state,后续取 state.settings.mcpServers 即最新。
    const target = resolveMcpToolServer(assistant, name, state.settings.mcpServers);
    if (target) await ensureFreshMcpToken(target.server);
    try {
      return await callMcpTool(assistant, name, args, state.settings.mcpServers, addLog);
    } catch (err) {
      // 决策④(7.2):MCP 失败把开发者向报错升级为机器可读的【结构化诊断】再回灌——模型靠
      // kind/retryable/action 一眼分清"可自救(重试/换工具)"还是"不可自救(告知用户)",
      // 不再对授权过期等救不活的故障死磕烧轮次。原始 exception 保留在 cause 尾部备查。
      // 错误仍走 toolExecutionErrorPayload 的 {error} 字符串契约,只是内容换成诊断文本——
      // 契约零变更,UI 失败卡与消息回放层不受影响。诊断抛出的同时喂给 Supervisor 记账。
      throw mcpToolFailureError(target?.server ?? null, name, err);
    }
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function saveToolBinaryContent(data: string, mime: string, prefix: string) {
  const fileId = state.nextFileId++;
  const fileName = `${prefix}-${Date.now()}-${fileId}${extensionFromMime(mime)}`;
  const target = join(filesDir, fileName);
  await Bun.write(target, Buffer.from(data, "base64"));
  const fileEntry: StoredFile = { id: fileId, path: target, fileName, mime, size: statSync(target).size };
  state.files.push(fileEntry);
  saveState();
  return `/api/files/${fileId}/content`;
}

/** 把各种工具原始返回值归一化为 ToolResult。
 *  特别地，MCP 返回的图片不再直接落盘，而是以 fileCreations 描述符交给协调器处理，
 *  避免工具执行层直接修改 state.files。 */
export async function toolResultToParts(toolResult: unknown): Promise<ToolResult> {
  if (isRecord(toolResult) && Array.isArray(toolResult.output)) {
    const fileCreations: Array<{ data: string; mime: string; prefix: string }> = [];
    if (Array.isArray(toolResult.fileCreations)) {
      for (const fc of toolResult.fileCreations) {
        if (isRecord(fc)) {
          fileCreations.push({
            data: String(fc.data ?? ""),
            mime: String(fc.mime ?? ""),
            prefix: String(fc.prefix ?? ""),
          });
        }
      }
    }
    return { output: toolResult.output as ToolOutputEntry[], ...(fileCreations.length ? { fileCreations } : {}) };
  }
  if (typeof toolResult === "string") return { output: [{ type: "text", text: toolResult }] };
  if (isRecord(toolResult) && Array.isArray(toolResult.content)) {
    const parts: MessagePart[] = [];
    const fileCreations: Array<{ data: string; mime: string; prefix: string }> = [];
    for (const item of toolResult.content) {
      if (!isRecord(item)) continue;
      const type = String(item.type ?? "").toLowerCase();
      if (type === "text") {
        parts.push({ type: "text", text: String(item.text ?? "") });
        continue;
      }
      if (type === "image") {
        const data = String(item.data ?? item.base64 ?? "");
        const mime = String(item.mimeType ?? item.mime_type ?? "image/png");
        if (data) {
          // 不直接保存文件，把描述符交给协调器，由它统一写盘并生成 /api/files/{id}/content URL。
          fileCreations.push({ data, mime, prefix: "mcp-image" });
        }
        continue;
      }
      if (type === "resource" && isRecord(item.resource)) {
        const resource = item.resource;
        const text = String(resource.text ?? "");
        if (text) parts.push({ type: "text", text });
        else parts.push({ type: "text", text: JSON.stringify(item) });
        continue;
      }
      parts.push({ type: "text", text: JSON.stringify(item) });
    }
    return { output: parts, ...(fileCreations.length ? { fileCreations } : {}) };
  }
  return { output: [{ type: "text", text: JSON.stringify(toolResult) }] };
}

/** 将 ToolResult 中的 fileCreations 落盘，并补充对应的 image parts。 */
export async function realizeToolResult(result: ToolResult): Promise<ToolOutputEntry[]> {
  const extra: MessagePart[] = [];
  if (result.fileCreations) {
    for (const fc of result.fileCreations) {
      const url = await saveToolBinaryContent(fc.data, fc.mime, fc.prefix);
      extra.push({ type: "image", url, metadata: { source: "mcp", mime: fc.mime } });
    }
  }
  return [...result.output, ...extra];
}

